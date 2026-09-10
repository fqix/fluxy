package winnet

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"sort"
	"syscall"
	"unsafe"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/splitdns"
	"golang.org/x/sys/windows"
)

func Command(command string, data []byte) (any, error) {
	switch command {
	case "system-proxy":
		return desktopProxyCommand(data)
	case "certificate-status":
		var request struct {
			DER string `json:"der"`
		}
		if err := protocol.Decode(data, &request); err != nil {
			return nil, err
		}
		raw, err := base64.StdEncoding.DecodeString(request.DER)
		if err != nil || len(raw) == 0 {
			return nil, errors.New("invalid certificate DER")
		}
		name, _ := windows.UTF16PtrFromString("ROOT")
		store, err := windows.CertOpenStore(windows.CERT_STORE_PROV_SYSTEM_W, 0, 0, windows.CERT_SYSTEM_STORE_LOCAL_MACHINE|windows.CERT_STORE_READONLY_FLAG|windows.CERT_STORE_OPEN_EXISTING_FLAG, uintptr(unsafe.Pointer(name)))
		if err != nil {
			return nil, err
		}
		defer windows.CertCloseStore(store, 0)
		var previous *windows.CertContext
		for {
			cert, err := windows.CertEnumCertificatesInStore(store, previous)
			if err != nil {
				if errors.Is(err, syscall.Errno(windows.CRYPT_E_NOT_FOUND)) {
					return false, nil
				}
				return nil, err
			}
			previous = cert
			if bytes.Equal(unsafe.Slice(cert.EncodedCert, cert.Length), raw) {
				windows.CertFreeCertificateContext(cert)
				return true, nil
			}
		}
	case "user-sid":
		return SID()
	case "dns-status":
		var request struct {
			InterfaceName string `json:"interfaceName"`
		}
		if err := protocol.Decode(data, &request); err != nil {
			return nil, err
		}
		return splitdns.RuleExists(request.InterfaceName)
	case "network-snapshot":
		return windowsNetworkSnapshot()
	case "proxy-processes":
		snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
		if err != nil {
			return nil, err
		}
		defer windows.CloseHandle(snapshot)
		entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
		lines := ""
		for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
			name := windows.UTF16ToString(entry.ExeFile[:])
			// Full paths let the desktop exclude its own installed sing-box.
			handle, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
			if openErr == nil {
				buffer := make([]uint16, 32768)
				size := uint32(len(buffer))
				if windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size) == nil {
					name = windows.UTF16ToString(buffer[:size])
				}
				windows.CloseHandle(handle)
			}
			lines += fmt.Sprintf("%d %s\n", entry.ProcessID, name)
		}
		if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
			return nil, err
		}
		return lines, nil
	case "route-interface":
		var request struct {
			Destination string `json:"destination"`
		}
		if err := protocol.Decode(data, &request); err != nil {
			return nil, err
		}
		if request.Destination == "default" {
			request.Destination = "8.8.8.8"
		} else if request.Destination != "1.1.1.1" && request.Destination != "198.18.0.1" {
			return nil, errors.New("invalid route probe")
		}
		address := net.ParseIP(request.Destination).To4()
		var sockaddr windows.SockaddrInet4
		copy(sockaddr.Addr[:], address)
		var index uint32
		if err := windows.GetBestInterfaceEx(&sockaddr, &index); err != nil {
			return nil, err
		}
		iface, err := net.InterfaceByIndex(int(index))
		if err != nil {
			return nil, err
		}
		return iface.Name, nil
	}
	return nil, errors.New("unsupported native network query")
}

func windowsNetworkSnapshot() (any, error) {
	routes := []string{}
	servers := []string{}
	var table *windows.MibIpForwardTable2
	if err := windows.GetIpForwardTable2(windows.AF_INET, &table); err != nil {
		return nil, err
	}
	defer windows.FreeMibTable(unsafe.Pointer(table))
	for _, row := range table.Rows() {
		addr := (*windows.RawSockaddrInet4)(unsafe.Pointer(&row.DestinationPrefix.Prefix))
		routes = append(routes, fmt.Sprintf("%s/%d", net.IP(addr.Addr[:]).String(), row.DestinationPrefix.PrefixLength))
	}
	size := uint32(15000)
	var buffer []byte
	var first *windows.IpAdapterAddresses
	loaded := false
	for attempt := 0; attempt < 5; attempt++ {
		buffer = make([]byte, size)
		first = (*windows.IpAdapterAddresses)(unsafe.Pointer(&buffer[0]))
		err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST, 0, first, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			continue
		}
		if err != nil {
			return nil, err
		}
		loaded = true
		break
	}
	if !loaded {
		return nil, errors.New("network adapters kept changing during discovery")
	}
	adapters := []*windows.IpAdapterAddresses{}
	for adapter := first; adapter != nil; adapter = adapter.Next {
		if adapter.OperStatus == windows.IfOperStatusUp {
			adapters = append(adapters, adapter)
		}
	}
	sort.SliceStable(adapters, func(i, j int) bool { return adapters[i].Ipv4Metric < adapters[j].Ipv4Metric })
	for _, adapter := range adapters {
		for dns := adapter.FirstDnsServerAddress; dns != nil; dns = dns.Next {
			if ip := dns.Address.IP(); ip != nil {
				servers = append(servers, ip.String())
			}
		}
	}
	return struct {
		Routes  []string `json:"routes"`
		Servers []string `json:"servers"`
	}{routes, servers}, nil
}
