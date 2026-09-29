// /request-account is a public page, like /login, and is laid out and
// translated as the login screens are: the same locale resolver (the
// pre-auth gml-locale cookie the language picker writes, English otherwise),
// the same wrapper and the same client bundle. So it is the login segment's
// own layout.

export { default } from "../login/layout";
