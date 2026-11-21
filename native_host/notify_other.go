//go:build !windows

package main

// Unix builds print to stderr and the log: the helper is usually started by the
// desktop session and has no dialog of its own.

import "fmt"

// showMessage reports a message the user should notice.
func showMessage(title, text string) {
	logf("%s: %s", title, text)
	fmt.Printf("%s: %s\n", title, text)
}

// notifyAlreadyRunning is called when a second copy fails to bind the port.
// The error already names the port, so only the instruction is appended.
func notifyAlreadyRunning(err error) {
	logf("already running: %v", err)
	fmt.Printf("%v，无需重复启动。\n", err)
}

// notifyListening prints the bound port.
func notifyListening(port int) {
	fmt.Printf("Bili helper listening on http://127.0.0.1:%d\n", port)
}

// notifyText prints CLI-style output.
func notifyText(title, text string) {
	fmt.Println(text)
}
