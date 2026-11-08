package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadSecret(t *testing.T) {
	dir := t.TempDir()
	good := strings.Repeat("ab", 32)
	cases := []struct {
		name, value string
		mode        os.FileMode
		ok          bool
	}{
		{"valid", good, 0o600, true},
		{"group readable", good, 0o640, false},
		{"short", good[:63], 0o600, false},
		{"long", good + "a", 0o600, false},
		{"not hex", strings.Repeat("zz", 32), 0o600, false},
	}
	for _, c := range cases {
		path := filepath.Join(dir, c.name)
		if err := os.WriteFile(path, []byte(c.value), c.mode); err != nil {
			t.Fatal(err)
		}
		os.Chmod(path, c.mode)
		got, err := readSecret(path)
		if (err == nil) != c.ok || (c.ok && got != c.value) {
			t.Errorf("%s: got %q, %v", c.name, got, err)
		}
	}
	link := filepath.Join(dir, "link")
	os.Symlink(filepath.Join(dir, "valid"), link)
	if _, err := readSecret(link); err == nil {
		t.Error("symlink accepted")
	}
}
