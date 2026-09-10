package winnet

import "golang.org/x/sys/windows"

// SID reports the calling user's security identifier, which pairs the helper
// to one desktop account.
func SID() (string, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}
