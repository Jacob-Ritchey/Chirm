package config

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Config holds all runtime configuration for Chirm.
// Values are loaded from environment variables (with .env file support).
type Config struct {
	Port          string
	HTTPSPort     string
	DataDir       string
	JWTSecret     string
	AllowedOrigin string
	TLSCert       string
	TLSKey        string
	MaxUploadMB   int64
}

// Load reads the .env file (if present) then populates Config from environment variables.
// Returns an error if required fields are missing or insecure.
func Load() (*Config, error) {
	loadDotenv(".env")

	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" ||
		jwtSecret == "change-this-secret-in-production" ||
		jwtSecret == "change-me-use-a-long-random-string-here" ||
		jwtSecret == "change-me-use-a-long-random-string" {
		return nil, fmt.Errorf("JWT_SECRET is not set or is using the insecure default value.\n" +
			"Generate one with:  openssl rand -hex 32\n" +
			"Then set it in your environment or .env file before starting Chirm.")
	}

	maxUploadMB := int64(50)
	if v := os.Getenv("MAX_UPLOAD_MB"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			maxUploadMB = n
		}
	}

	return &Config{
		Port:          getEnv("PORT", "8080"),
		HTTPSPort:     getEnv("HTTPS_PORT", "8443"),
		DataDir:       getEnv("DATA_DIR", "./data"),
		JWTSecret:     jwtSecret,
		AllowedOrigin: os.Getenv("ALLOWED_ORIGIN"),
		TLSCert:       os.Getenv("CHIRM_TLS_CERT"),
		TLSKey:        os.Getenv("CHIRM_TLS_KEY"),
		MaxUploadMB:   maxUploadMB,
	}, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// loadDotenv reads a .env file and sets any environment variables that are not
// already present in the environment. Silently does nothing if the file doesn't exist.
func loadDotenv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		idx := strings.IndexByte(line, '=')
		if idx < 1 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.TrimSpace(line[idx+1:])
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		if os.Getenv(key) == "" {
			os.Setenv(key, val)
		}
	}
}
