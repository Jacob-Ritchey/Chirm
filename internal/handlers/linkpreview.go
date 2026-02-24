package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ─── Cache ────────────────────────────────────────────────────────────────────

type previewEntry struct {
	data      LinkPreview
	fetchedAt time.Time
}

var (
	previewCache   sync.Map        // key: normalised URL → previewEntry
	previewTTL     = 2 * time.Hour // re-fetch after this long
	previewTimeout = 6 * time.Second
)

// ─── Model ────────────────────────────────────────────────────────────────────

type LinkPreview struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
	Favicon     string `json:"favicon,omitempty"`
	Error       string `json:"error,omitempty"`
}

// ─── OG regex helpers ─────────────────────────────────────────────────────────

var (
	reOGTitle       = buildMetaRe(`og:title`, `twitter:title`)
	reOGDesc        = buildMetaRe(`og:description`, `twitter:description`)
	reOGImage       = buildMetaRe(`og:image`, `twitter:image`, `twitter:image:src`)
	reOGSite        = buildMetaRe(`og:site_name`, `twitter:site`)
	reMetaDesc      = regexp.MustCompile(`(?i)<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']`)
	reMetaDescAlt   = regexp.MustCompile(`(?i)<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']`)
	reTitle         = regexp.MustCompile(`(?i)<title[^>]*>([^<]+)</title>`)
	reLinkIcon      = regexp.MustCompile(`(?i)<link[^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["'][^>]+href=["']([^"']+)["']`)
	reLinkIconAlt   = regexp.MustCompile(`(?i)<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*(?:shortcut )?icon[^"']*["']`)
)

func buildMetaRe(props ...string) *regexp.Regexp {
	// Matches: <meta property="og:title" content="..."> and alternate attr order
	var alts []string
	for _, p := range props {
		ep := regexp.QuoteMeta(p)
		alts = append(alts,
			// property/name before content
			`(?i)<meta[^>]+(?:property|name)=["']`+ep+`["'][^>]+content=["']([^"']{1,400})["']`,
			// content before property/name
			`(?i)<meta[^>]+content=["']([^"']{1,400})["'][^>]+(?:property|name)=["']`+ep+`["']`,
		)
	}
	return regexp.MustCompile(`(?:` + strings.Join(alts, `|`) + `)`)
}

func firstGroup(re *regexp.Regexp, body string) string {
	m := re.FindStringSubmatch(body)
	if m == nil {
		return ""
	}
	// Walk sub-groups to find first non-empty
	for _, g := range m[1:] {
		if g != "" {
			return strings.TrimSpace(g)
		}
	}
	return ""
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

var previewClient = &http.Client{
	Timeout: previewTimeout,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

func fetchPreview(rawURL string) LinkPreview {
	// Check cache
	if v, ok := previewCache.Load(rawURL); ok {
		e := v.(previewEntry)
		if time.Since(e.fetchedAt) < previewTTL {
			return e.data
		}
	}

	pv := scrapePreview(rawURL)

	previewCache.Store(rawURL, previewEntry{data: pv, fetchedAt: time.Now()})
	return pv
}

func scrapePreview(rawURL string) LinkPreview {
	pv := LinkPreview{URL: rawURL}

	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		pv.Error = "invalid URL"
		return pv
	}

	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		pv.Error = "request error"
		return pv
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; Chirm/1.0; +https://chirm.app) LinkPreview")
	req.Header.Set("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.5")

	resp, err := previewClient.Do(req)
	if err != nil {
		pv.Error = "fetch failed"
		return pv
	}
	defer resp.Body.Close()

	// Only parse HTML-ish responses; skip binary/media
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "html") {
		pv.Error = "not HTML"
		return pv
	}

	// Read up to 256KB — enough for any <head> section
	lr := io.LimitReader(resp.Body, 256*1024)
	bodyBytes, err := io.ReadAll(lr)
	if err != nil {
		pv.Error = "read error"
		return pv
	}
	body := string(bodyBytes)

	// Extract fields
	pv.Title = firstGroup(reOGTitle, body)
	pv.Description = firstGroup(reOGDesc, body)
	pv.Image = firstGroup(reOGImage, body)
	pv.SiteName = firstGroup(reOGSite, body)

	// Fallbacks
	if pv.Title == "" {
		pv.Title = strings.TrimSpace(firstGroup(reTitle, body))
	}
	if pv.Description == "" {
		pv.Description = firstGroup(reMetaDesc, body)
	}
	if pv.Description == "" {
		pv.Description = firstGroup(reMetaDescAlt, body)
	}
	if pv.SiteName == "" && parsed.Host != "" {
		pv.SiteName = strings.TrimPrefix(parsed.Host, "www.")
	}

	// Favicon
	favicon := firstGroup(reLinkIcon, body)
	if favicon == "" {
		favicon = firstGroup(reLinkIconAlt, body)
	}
	if favicon == "" {
		favicon = "/favicon.ico"
	}
	pv.Favicon = resolveURL(parsed, favicon)

	// Resolve relative image URL
	if pv.Image != "" && !strings.HasPrefix(pv.Image, "http") {
		pv.Image = resolveURL(parsed, pv.Image)
	}

	// Truncate description
	if len([]rune(pv.Description)) > 200 {
		runes := []rune(pv.Description)
		pv.Description = string(runes[:197]) + "…"
	}

	return pv
}

func resolveURL(base *url.URL, ref string) string {
	r, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return base.ResolveReference(r).String()
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────

func (h *Handler) LinkPreview(w http.ResponseWriter, r *http.Request) {
	rawURL := r.URL.Query().Get("url")
	if rawURL == "" {
		errResp(w, http.StatusBadRequest, "url required")
		return
	}

	// Basic validation — must be http/https
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		errResp(w, http.StatusBadRequest, "invalid URL scheme")
		return
	}

	pv := fetchPreview(rawURL)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	json.NewEncoder(w).Encode(pv)
}
