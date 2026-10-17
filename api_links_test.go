package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func newLinkTestApp(t *testing.T) *App {
	t.Helper()
	dataDir = t.TempDir() // audit() writes under the global dataDir
	store, err := LoadStore(dataDir)
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	return &App{store: store}
}

func postLink(t *testing.T, app *App, path, body string) map[string]any {
	t.Helper()
	req := httptest.NewRequest("POST", path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	switch path {
	case "/api/links/save":
		app.handleLinkSave(rec, req, nil)
	case "/api/links/delete":
		app.handleLinkDelete(rec, req, nil)
	case "/api/links/move":
		app.handleLinkMove(rec, req, nil)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: bad JSON %q: %v", path, rec.Body.String(), err)
	}
	return out
}

func linkCount(app *App) int {
	n := 0
	app.store.Read(func(c *Config) { n = len(c.QuickLinks) })
	return n
}

func TestLinkSaveValidation(t *testing.T) {
	app := newLinkTestApp(t)
	cases := []struct {
		body string
		want int // expected HTTP-ish ok flag: 400 -> ok=false
	}{
		{`{"name":"","url":"http://x.test"}`, 400},
		{`{"name":"A","url":""}`, 400},
		{`{"name":"A","url":"javascript:alert(1)"}`, 400},
		{`{"name":"A","url":"ftp://x.test"}`, 400},
		{`{"name":"A","url":"http://"}`, 400},
		{`{"name":"A","url":"not a url"}`, 400},
		{`{"name":"A","url":"https://x.test"}`, 200},
	}
	for _, c := range cases {
		got := postLink(t, app, "/api/links/save", c.body)
		code, _ := got["ok"].(bool)
		if c.want == 400 && code {
			t.Errorf("save %s: want rejection, got %+v", c.body, got)
		}
		if c.want == 200 && !code {
			t.Errorf("save %s: want ok, got %+v", c.body, got)
		}
	}
	if n := linkCount(app); n != 1 {
		t.Errorf("stored %d links, want 1 (rejections must not persist)", n)
	}
}

func TestLinkSaveDefaultsAndUpsert(t *testing.T) {
	app := newLinkTestApp(t)
	got := postLink(t, app, "/api/links/save", `{"name":"WebDAV","url":"http://192.0.2.10:8080","group":"WebDAV"}`)
	l := got["link"].(map[string]any)
	if l["id"] == "" || l["icon"] != "🔗" {
		t.Errorf("default id/icon missing: %+v", l)
	}
	id := l["id"].(string)
	// update the same id: must replace, not append
	postLink(t, app, "/api/links/save", `{"id":"`+id+`","name":"WebDAV ZT","url":"http://192.0.2.10:8080","icon":"🛰","group":"WebDAV"}`)
	var links []QuickLink
	app.store.Read(func(c *Config) { links = c.QuickLinks })
	if len(links) != 1 || links[0].Name != "WebDAV ZT" || links[0].Icon != "🛰" {
		t.Errorf("upsert failed: %+v", links)
	}
}

func TestLinkMoveAndDelete(t *testing.T) {
	app := newLinkTestApp(t)
	var ids []string
	for _, n := range []string{"a", "b", "c"} {
		got := postLink(t, app, "/api/links/save", `{"name":"`+n+`","url":"https://`+n+`.test"}`)
		ids = append(ids, got["link"].(map[string]any)["id"].(string))
	}
	postLink(t, app, "/api/links/move", `{"id":"`+ids[2]+`","dir":"up"}`)
	var names []string
	app.store.Read(func(c *Config) {
		for _, l := range c.QuickLinks {
			names = append(names, l.Name)
		}
	})
	if strings.Join(names, ",") != "a,c,b" {
		t.Errorf("after move up: %v", names)
	}
	// boundary: moving the first up is a no-op
	postLink(t, app, "/api/links/move", `{"id":"`+ids[0]+`","dir":"up"}`)
	postLink(t, app, "/api/links/delete", `{"id":"`+ids[0]+`"}`)
	if n := linkCount(app); n != 2 {
		t.Errorf("after delete: %d links, want 2", n)
	}
}
