package main

import "testing"

func TestNativeInstallerResult(t *testing.T) {
	for _, test := range []struct {
		name, output string
		ok           bool
	}{
		{"success", "marker:0\n", true},
		{"output", "installer output\nmarker:0\n", true},
		{"failure", "permission denied\nmarker:1\n", false},
		{"missing result", "installer died", false},
		{"incomplete", "marker:", false},
		{"not a result line", "error marker:0\n", false},
		{"trailing failure", "marker:0\nmarker:1\n", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := nativeInstallerResult([]byte(test.output), "marker:")
			if (err == nil) != test.ok {
				t.Fatalf("result error = %v, success want %v", err, test.ok)
			}
		})
	}
}
