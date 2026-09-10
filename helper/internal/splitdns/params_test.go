package splitdns

import "testing"

func TestCaptureDomains(t *testing.T) {
	for _, domains := range [][]string{{"example.com"}, {"example.com", "api.example.net"}} {
		if err := validateDomains(domains); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		name    string
		domains []string
	}{
		{"nil domains", nil},
		{"empty domains", []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if validateDomains(test.domains) == nil {
				t.Fatal("accepted missing capture domains")
			}
		})
	}
	for _, domain := range []string{"", "   ", ".", "*", "*.example.com", "https://example.com", "example.com:443", "example.com/path", "a..com", "-a.com", "a-.com", "a_b.com", "example.com\nremove other", "127.0.0.1", "::1", "Example.com"} {
		t.Run(domain, func(t *testing.T) {
			if validateDomains([]string{domain}) == nil {
				t.Fatal("accepted unsafe resolver domain")
			}
		})
	}
}
