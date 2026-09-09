package main

import (
	"strings"
	"testing"
	"unsafe"
)

func TestDesktopProxyInputAndLayout(t *testing.T) {
	if unsafe.Sizeof(internetOption{}) != 16 || unsafe.Offsetof(internetOption{}.Value) != 8 || unsafe.Sizeof(internetOptionList{}) != 32 || unsafe.Offsetof(internetOptionList{}.Options) != 24 {
		t.Fatal("invalid WinINet amd64/arm64 layout")
	}
	valid := desktopProxyValues{Flags: "13", Server: "http=old:8080;socks=localhost:7890", Bypass: "<local>;*.公司", PAC: "https://example.com/pac?x=';$value"}
	if _, err := valid.validate(); err != nil {
		t.Fatal(err)
	}
	for _, flags := range []string{"", "-1", "16", "4294967296", "3;evil"} {
		v := valid
		v.Flags = flags
		if _, err := v.validate(); err == nil {
			t.Fatalf("accepted flags %q", flags)
		}
	}
	for _, text := range []string{"embedded\x00zero", strings.Repeat("x", 32769)} {
		v := valid
		v.PAC = text
		if _, err := v.validate(); err == nil {
			t.Fatal("accepted invalid proxy string")
		}
	}
	// Invalid writes must fail before touching WinINet.
	for _, input := range []string{`{}`, `{"flags":"3","command":"anything"}`, `{"flags":"16"}`, `{"flags":3}`, `null {}`} {
		if _, err := desktopProxyCommand([]byte(input)); err == nil {
			t.Fatalf("accepted invalid command %s", input)
		}
	}
}
func TestReadDesktopProxyNative(t *testing.T) {
	values, err := readDesktopProxy()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = values.validate(); err != nil {
		t.Fatal(err)
	}
}
