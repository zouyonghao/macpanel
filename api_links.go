package main

import (
	"net/http"
	"net/url"
	"strings"
)

// GET /api/links
func (app *App) handleLinkList(w http.ResponseWriter, r *http.Request, s *Session) {
	var links []QuickLink
	app.store.Read(func(c *Config) {
		links = append([]QuickLink(nil), c.QuickLinks...)
	})
	apiOK(w, map[string]any{"links": links})
}

// POST /api/links/save {id, name, url, icon, group} — empty id adds, an existing id updates
func (app *App) handleLinkSave(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		URL   string `json:"url"`
		Icon  string `json:"icon"`
		Group string `json:"group"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.URL = strings.TrimSpace(req.URL)
	req.Group = strings.TrimSpace(req.Group)
	req.Icon = strings.TrimSpace(req.Icon)
	if req.Name == "" || req.URL == "" {
		apiErr(w, 400, "Name and URL are required")
		return
	}
	// Only http(s) is allowed: the URL is rendered into href, so schemes like
	// javascript: would be an XSS vector
	u, err := url.Parse(req.URL)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		apiErr(w, 400, "URL must be a valid http(s) address")
		return
	}
	if runeLen(req.Name) > 64 || runeLen(req.Group) > 32 || runeLen(req.Icon) > 8 || runeLen(req.URL) > 500 {
		apiErr(w, 400, "Field too long")
		return
	}
	if req.Icon == "" {
		req.Icon = "🔗"
	}
	if req.ID == "" {
		req.ID = randomToken(8)
	}
	l := QuickLink{ID: req.ID, Name: req.Name, URL: req.URL, Icon: req.Icon, Group: req.Group}
	updated := false
	_ = app.store.Update(func(c *Config) {
		for i := range c.QuickLinks {
			if c.QuickLinks[i].ID == req.ID {
				c.QuickLinks[i] = l
				updated = true
				return
			}
		}
		c.QuickLinks = append(c.QuickLinks, l)
	})
	app.audit("link_save", l.Name)
	apiOK(w, map[string]any{"link": l, "updated": updated})
}

// POST /api/links/delete {id}
func (app *App) handleLinkDelete(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	_ = app.store.Update(func(c *Config) {
		out := c.QuickLinks[:0]
		for _, l := range c.QuickLinks {
			if l.ID != req.ID {
				out = append(out, l)
			}
		}
		c.QuickLinks = out
	})
	app.audit("link_delete", req.ID)
	apiOK(w, nil)
}

// POST /api/links/move {id, dir} — dir is "up" or "down", swaps with the neighbor
func (app *App) handleLinkMove(w http.ResponseWriter, r *http.Request, s *Session) {
	var req struct {
		ID  string `json:"id"`
		Dir string `json:"dir"`
	}
	if err := readJSON(r, &req); err != nil {
		apiErr(w, 400, "Invalid request")
		return
	}
	_ = app.store.Update(func(c *Config) {
		for i := range c.QuickLinks {
			if c.QuickLinks[i].ID != req.ID {
				continue
			}
			j := i - 1
			if req.Dir == "down" {
				j = i + 1
			}
			if j < 0 || j >= len(c.QuickLinks) {
				return
			}
			c.QuickLinks[i], c.QuickLinks[j] = c.QuickLinks[j], c.QuickLinks[i]
			return
		}
	})
	apiOK(w, nil)
}

func runeLen(s string) int { return len([]rune(s)) }
