//go:build darwin || windows

package splitdns

import (
	"fmt"
	"net"
	"strings"
	"time"
)

func WaitReady(domains []string) error {
	deadline := time.Now().Add(8 * time.Second)
	// Query a matched domain so readiness never depends on an external DNS answer.
	name := "fluxy.invalid"
	if len(domains) > 0 {
		name = domains[0]
	}
	query := []byte{0x46, 0x58, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, label := range strings.Split(name, ".") {
		query = append(query, byte(len(label)))
		query = append(query, label...)
	}
	query = append(query, 0, 0, 1, 0, 1)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("udp", Address+":53", 300*time.Millisecond)
		if err == nil {
			_ = connection.SetDeadline(time.Now().Add(300 * time.Millisecond))
			_, err = connection.Write(query)
			reply := make([]byte, 512)
			if err == nil {
				var count int
				count, err = connection.Read(reply)
				if err == nil && count >= 12 && reply[0] == 0x46 && reply[1] == 0x58 &&
					reply[2]&0x80 != 0 && reply[3]&15 == 0 && (reply[6] != 0 || reply[7] != 0) {
					connection.Close()
					return nil
				}
			}
			connection.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("Fluxy Fake IP DNS did not become ready at %s", Address)
}
