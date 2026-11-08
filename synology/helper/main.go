// t3-key is the DSM identity gateway's token adapter. After the gateway admits
// a DSM administrator, it adds the per-install gateway key that t3-gate in the
// container requires. The key is the SDK-generated Compose runtime secret
// `gateway-key`; the container receives the same value as T3_GATE_KEY.
// It never reaches the browser.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// Installed at <target>/daemon/payload/t3-key; the SDK writes the secret to
// <target>/compose/secrets/runtime-gateway-key.secret.
const secretRelative = "../../compose/secrets/runtime-gateway-key.secret"

func main() {
	key, err := readKey()
	if err != nil {
		fmt.Fprintln(os.Stderr, "t3-key:", err)
		os.Exit(1)
	}
	_ = json.NewEncoder(os.Stdout).Encode(map[string]map[string][]string{
		"headers": {"X-Synopkgland-T3-Key": {key}},
	})
}

func readKey() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	return readSecret(filepath.Join(filepath.Dir(self), secretRelative))
}

// readSecret accepts only the SDK's private 64-hex-character file.
func readSecret(path string) (string, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return "", err
	}
	if !st.Mode().IsRegular() || st.Mode().Perm()&0o077 != 0 {
		return "", errors.New("gateway key must be a private regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, 65))
	if err != nil {
		return "", err
	}
	if len(b) != 64 {
		return "", errors.New("gateway key has an unexpected length")
	}
	for _, c := range b {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return "", errors.New("gateway key has an unexpected encoding")
		}
	}
	return string(b), nil
}
