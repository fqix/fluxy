package daemon

import (
	"context"

	"golang.org/x/sys/windows/svc"

	"dev.fengqi.fluxy/helper/internal/protocol"
	"dev.fengqi.fluxy/helper/internal/splitdns"
)

type service struct{}

func (service) Execute(_ []string, r <-chan svc.ChangeRequest, s chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s <- svc.Status{State: svc.StartPending}
	done := make(chan error, 1)
	go func() {
		if err := splitdns.Recover(); err != nil {
			done <- err
			return
		}
		done <- run(ctx)
	}()
	s <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-done:
			if err != nil {
				return true, 1
			}
			return false, 0
		case c := <-r:
			switch c.Cmd {
			case svc.Interrogate:
				s <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				s <- svc.Status{State: svc.StopPending, WaitHint: 20000}
				cancel()
				if err := <-done; err != nil {
					return true, 1
				}
				return false, 0
			}
		}
	}
}

// Main runs the helper as a Windows service.
func Main() error { return svc.Run(protocol.ServiceID, service{}) }
