package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Monitor is a custom monitoring item
type Monitor struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`   // launchd | port | http | process
	Target    string    `json:"target"` // launchd label / host:port / url / process name
	Enabled   bool      `json:"enabled"`
	LastOK    bool      `json:"last_ok"`
	LastCheck time.Time `json:"last_check"`
	LatencyMs float64   `json:"latency_ms"`
	LastError string    `json:"last_error"`
}

// Site is a Caddy reverse-proxy/static site
type Site struct {
	Domain  string `json:"domain"` // may include a port, e.g. example.com:8443
	Type    string `json:"type"`   // proxy | static
	Target  string `json:"target"` // proxy: 127.0.0.1:8083 ; static: absolute directory path
	TLS     string `json:"tls"`    // none | internal | files
	Cert    string `json:"cert"`   // certificate path when tls=files
	Key     string `json:"key"`
	Enabled bool   `json:"enabled"`
}

type User struct {
	Name string `json:"name"`
	Hash string `json:"hash"` // argon2id encoded string
}

type KnownService struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Port int    `json:"port"`
}

// QuickLink is a bookmark on the Quick Links (navigation) page
type QuickLink struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	URL   string `json:"url"`
	Icon  string `json:"icon"`  // short emoji/text badge
	Group string `json:"group"` // optional section name
}

type AISettings struct {
	BaseURL string `json:"base_url"`
	Key     string `json:"key"`
	Model   string `json:"model"`
}

type Config struct {
	Listen        string         `json:"listen"`
	HTTPPort      string         `json:"http_port"` // HTTP redirect port when TLS is enabled; empty disables it
	Entrance      string         `json:"entrance"`
	TLSCert       string         `json:"tls_cert"`
	TLSKey        string         `json:"tls_key"`
	SessionHours  int            `json:"session_hours"`
	IPAllowlist   []string       `json:"ip_allowlist"`
	Users         []User         `json:"users"`
	Monitors      []Monitor      `json:"monitors"`
	Sites         []Site         `json:"sites"`
	FavoritePorts []int          `json:"favorite_ports"`
	KnownServices []KnownService `json:"known_services"`
	QuickLinks    []QuickLink    `json:"quick_links"`
	AI            AISettings     `json:"ai"`
}

type Store struct {
	mu   sync.Mutex
	path string
	Cfg  *Config
}

func LoadStore(dataDir string) (*Store, error) {
	s := &Store{path: filepath.Join(dataDir, "config.json")}
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.Cfg = defaultConfig()
			_ = s.saveLocked()
			return s, nil
		}
		return nil, err
	}
	cfg := &Config{}
	if err := json.Unmarshal(b, cfg); err != nil {
		return nil, err
	}
	s.Cfg = cfg
	return s, nil
}

func defaultConfig() *Config {
	return &Config{
		Listen:       ":9000",
		SessionHours: 24,
		AI:           AISettings{BaseURL: "https://api.deepseek.com", Model: "deepseek-chat"},
	}
}

func (s *Store) Save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked()
}

func (s *Store) saveLocked() error {
	b, err := json.MarshalIndent(s.Cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *Store) Update(fn func(c *Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.Cfg)
	return s.saveLocked()
}

// Read reads the config under the lock (copy out the fields you need)
func (s *Store) Read(fn func(c *Config)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s.Cfg)
}
