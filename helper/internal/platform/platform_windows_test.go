package platform

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestNamedPipePeerCredentials(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	path := fmt.Sprintf(`\\.\pipe\fluxy-test-%d-%d`, os.Getpid(), time.Now().UnixNano())
	listener, err := winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + sid + ")"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	accepted := make(chan error, 1)
	go func() {
		peer, err := listener.Accept()
		if err != nil {
			accepted <- err
			return
		}
		defer peer.Close()
		p := protocol.Pairing{SID: sid}
		p.Caller.Path, _ = os.Executable()
		p.Caller.SHA256, _ = protocol.FileHash(p.Caller.Path)
		if !PeerAllowed(peer, p) {
			accepted <- fmt.Errorf("valid peer rejected")
			return
		}
		p.SID = "S-1-5-18"
		if sid == p.SID {
			p.SID = "S-1-5-19"
		}
		if PeerAllowed(peer, p) {
			accepted <- fmt.Errorf("different user accepted")
			return
		}
		accepted <- nil
	}()
	client, err := winio.DialPipeContext(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	select {
	case err = <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
}
