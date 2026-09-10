package splitdns

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"regexp"
	"strings"
	"time"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// MS-GPNRPT documents the registry layout and values. The DNS service observes
// local policy changes; domain Group Policy can suppress all local rules.
const nrptLocal = `SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig`
const nrptGroupPolicy = `SOFTWARE\Policies\Microsoft\Windows NT\DNSClient\DnsPolicyConfig`

type nrptStore struct {
	root          registry.Key
	local, policy string
	flush         func() error
	verify        func([]string) error
}
type nrptRule struct {
	id, owner string
	domains   []string
}

// RuleExists reports whether the helper owns an active NRPT rule for one
// interface.
func RuleExists(interfaceName string) (bool, error) { return systemNRPT().exists(interfaceName) }

func systemNRPT() nrptStore {
	return nrptStore{registry.LOCAL_MACHINE, nrptLocal, nrptGroupPolicy, flushWindowsDNS, verifyWindowsDNS}
}

func verifyWindowsDNS(domains []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	names := []string{domains[0]}
	if len(domains[0])+len("fluxy-nrpt-check.") <= 253 {
		names = append(names, "fluxy-nrpt-check."+domains[0])
	}
	var lastErr error
	for {
		lastErr = nil
		// Let the DNS service observe the new keys and discard pre-activation answers.
		if err := flushWindowsDNS(); err != nil {
			return err
		}
		for _, name := range names {
			addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", name)
			if err != nil {
				lastErr = err
				break
			}
			if len(addresses) == 0 {
				lastErr = errors.New("no DNS answers")
				break
			}
			for _, addr := range addresses {
				if !netip.MustParsePrefix("198.19.0.0/16").Contains(addr) && !netip.MustParsePrefix("100.127.0.0/16").Contains(addr) && !netip.MustParsePrefix("172.30.0.0/16").Contains(addr) {
					lastErr = errors.New("Windows policy bypassed Fluxy scoped DNS")
					break
				}
			}
			if lastErr != nil {
				break
			}
		}
		if lastErr == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Windows scoped DNS did not activate: %w", lastErr)
		case <-time.After(150 * time.Millisecond):
		}
	}
}

func (s nrptStore) rules(path string) ([]nrptRule, error) {
	key, err := registry.OpenKey(s.root, path, registry.READ)
	if errors.Is(err, registry.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer key.Close()
	names, err := key.ReadSubKeyNames(-1)
	if err != nil {
		return nil, err
	}
	var rules []nrptRule
	for _, name := range names {
		entry, err := registry.OpenKey(key, name, registry.READ)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		domains, _, readErr := entry.GetStringsValue("Name")
		owner, _, _ := entry.GetStringValue("Comment")
		entry.Close()
		if readErr != nil && !errors.Is(readErr, registry.ErrNotExist) {
			return nil, readErr
		}
		rules = append(rules, nrptRule{name, owner, domains})
	}
	return rules, nil
}
func ownedDNSInterface(owner string) string {
	name := strings.TrimPrefix(owner, protocol.ServiceID+".")
	if name == owner || !regexp.MustCompile(`^fluxy[0-9]{4,5}$`).MatchString(name) {
		return ""
	}
	return name
}
func dnsScopesOverlap(scope, domain string) bool {
	scope = strings.ToLower(strings.TrimPrefix(scope, "."))
	return scope == "" || scope == domain || strings.HasSuffix(domain, "."+scope) || strings.HasSuffix(scope, "."+domain)
}
func (s nrptStore) remove(owner string) error {
	rules, err := s.rules(s.local)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		if rule.owner != owner {
			continue
		}
		if err := registry.DeleteKey(s.root, s.local+`\`+rule.id); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return err
		}
	}
	return s.flush()
}
func (s nrptStore) exists(name string) (bool, error) {
	if !protocol.ValidInterfaceName(name) {
		return false, errors.New("invalid split DNS interface")
	}
	rules, err := s.rules(s.local)
	if err != nil {
		return false, err
	}
	for _, rule := range rules {
		if rule.owner == protocol.ServiceID+"."+name {
			return true, nil
		}
	}
	return false, nil
}

// Volatile keys disappear at reboot, including when both owner processes crash.
func createVolatileKey(root registry.Key, path string) (registry.Key, error) {
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("RegCreateKeyExW")
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var key windows.Handle
	var disposition uint32
	status, _, _ := proc.Call(uintptr(root), uintptr(unsafe.Pointer(name)), 0, 0, 1, registry.ALL_ACCESS, 0, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&disposition)))
	if status != 0 {
		return 0, windows.Errno(status)
	}
	if disposition != 1 {
		windows.RegCloseKey(key)
		return 0, errors.New("NRPT rule already exists")
	}
	return registry.Key(key), nil
}
func (s nrptStore) install(name string, domains []string) (func() error, error) {
	if !protocol.ValidInterfaceName(name) {
		return nil, errors.New("invalid split DNS interface")
	}
	if err := validateDomains(domains); err != nil {
		return nil, err
	}
	policies, err := s.rules(s.policy)
	if err != nil {
		return nil, err
	}
	if len(policies) != 0 {
		return nil, errors.New("Group Policy DNS rules prevent local scoped TUN; use HTTP Proxy mode")
	}
	rules, err := s.rules(s.local)
	if err != nil {
		return nil, err
	}
	for _, rule := range rules {
		for _, scope := range rule.domains {
			for _, domain := range domains {
				if dnsScopesOverlap(scope, domain) {
					return nil, errors.New("an existing DNS policy overlaps a capture domain")
				}
			}
		}
	}
	owner := protocol.ServiceID + "." + name
	cleanup := func() error { return s.remove(owner) }
	// One exact+suffix pair per rule stays below Windows' namespace count limit.
	for _, domain := range domains {
		guid, err := windows.GenerateGUID()
		if err != nil {
			return cleanup, err
		}
		path := s.local + `\` + guid.String()
		key, err := createVolatileKey(s.root, path)
		if err != nil {
			return cleanup, err
		}
		err = key.SetStringValue("Comment", owner)
		if err == nil {
			err = key.SetDWordValue("Version", 2)
		}
		if err == nil {
			err = key.SetStringsValue("Name", []string{domain, "." + domain})
		}
		if err == nil {
			err = key.SetStringValue("GenericDNSServers", Address)
		}
		if err == nil {
			err = key.SetDWordValue("ConfigOptions", 8)
		}
		key.Close()
		if err != nil {
			return cleanup, errors.Join(err, registry.DeleteKey(s.root, path))
		}
	}
	return cleanup, s.flush()
}
func flushWindowsDNS() error {
	proc := windows.NewLazySystemDLL("dnsapi.dll").NewProc("DnsFlushResolverCache")
	if err := proc.Find(); err != nil {
		return err
	}
	result, _, err := proc.Call()
	if result == 0 {
		return fmt.Errorf("cannot flush Windows DNS cache: %w", err)
	}
	return nil
}
func FlushCache() { _ = flushWindowsDNS() }
func Recover() error {
	s := systemNRPT()
	rules, err := s.rules(s.local)
	if err != nil {
		return err
	}
	for _, rule := range rules {
		name := ownedDNSInterface(rule.owner)
		if name == "" {
			continue
		}
		if _, err := net.InterfaceByName(name); err == nil {
			return errors.New("a previous Fluxy TUN interface is still active")
		}
		if err := s.remove(rule.owner); err != nil {
			return err
		}
	}
	return nil
}
