package main

import (
	"bytes"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// WinINet runs in the desktop user's short-lived process, never the SYSTEM service.
// The native layouts below target the supported Windows amd64/arm64 builds.
type internetOption struct {
	ID    uint32
	Value uint64
}
type internetOptionList struct {
	Size       uint32
	Connection *uint16
	Count      uint32
	Error      uint32
	Options    *internetOption
}
type desktopProxyValues struct {
	Flags  string `json:"flags"`
	Server string `json:"server"`
	Bypass string `json:"bypass"`
	PAC    string `json:"pac"`
}

func (v desktopProxyValues) validate() (uint32, error) {
	n, err := strconv.ParseUint(v.Flags, 10, 32)
	if err != nil || n&^uint64(15) != 0 {
		return 0, errors.New("invalid Windows proxy flags")
	}
	for _, value := range []string{v.Server, v.Bypass, v.PAC} {
		if len(value) > 32768 || strings.ContainsRune(value, 0) {
			return 0, errors.New("invalid Windows proxy string")
		}
	}
	return uint32(n), nil
}

var wininet = windows.NewLazySystemDLL("wininet.dll")
var queryInternetOption = wininet.NewProc("InternetQueryOptionW")
var setInternetOption = wininet.NewProc("InternetSetOptionW")
var freeInternetString = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")

func proxyOptionList(options *[4]internetOption) internetOptionList {
	return internetOptionList{Size: uint32(unsafe.Sizeof(internetOptionList{})), Count: 4, Options: &options[0]}
}
func readDesktopProxy() (desktopProxyValues, error) {
	// FLAGS_UI preserves the saved auto-detect bit even after detection fails.
	options := [4]internetOption{{ID: 10}, {ID: 2}, {ID: 3}, {ID: 4}}
	list := proxyOptionList(&options)
	size := list.Size
	ok, _, err := queryInternetOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(unsafe.Pointer(&size)))
	defer func() {
		for i := 1; i < 4; i++ {
			if options[i].Value != 0 {
				freeInternetString.Call(uintptr(options[i].Value))
			}
		}
	}()
	if ok == 0 {
		return desktopProxyValues{}, fmt.Errorf("read Windows proxy (option %d): %w", list.Error, err)
	}
	text := func(i int) string {
		if options[i].Value == 0 {
			return ""
		}
		return windows.UTF16PtrToString(*(**uint16)(unsafe.Pointer(&options[i].Value)))
	}
	return desktopProxyValues{strconv.FormatUint(uint64(uint32(options[0].Value)), 10), text(1), text(2), text(3)}, nil
}
func writeDesktopProxy(v desktopProxyValues) error {
	flags, err := v.validate()
	if err != nil {
		return err
	}
	options := [4]internetOption{{ID: 1, Value: uint64(flags)}, {ID: 2}, {ID: 3}, {ID: 4}}
	var buffers [3][]uint16
	for i, value := range []string{v.Server, v.Bypass, v.PAC} {
		buffers[i], err = windows.UTF16FromString(value)
		if err != nil {
			return err
		}
		*(**uint16)(unsafe.Pointer(&options[i+1].Value)) = &buffers[i][0]
	}
	list := proxyOptionList(&options)
	ok, _, callErr := setInternetOption.Call(0, 75, uintptr(unsafe.Pointer(&list)), uintptr(list.Size))
	runtime.KeepAlive(buffers)
	if ok == 0 {
		return fmt.Errorf("write Windows proxy (option %d): %w", list.Error, callErr)
	}
	for _, option := range []uintptr{39, 95, 37} {
		ok, _, callErr = setInternetOption.Call(0, option, 0, 0)
		if ok == 0 {
			return fmt.Errorf("notify Windows proxy change (%d): %w", option, callErr)
		}
	}
	return nil
}
func desktopProxyCommand(data []byte) (any, error) {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return readDesktopProxy()
	}
	var v desktopProxyValues
	if err := decode(data, &v); err != nil {
		return nil, err
	}
	if err := writeDesktopProxy(v); err != nil {
		return nil, err
	}
	return readDesktopProxy()
}
