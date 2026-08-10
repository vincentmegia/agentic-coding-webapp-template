// Package migrations embeds the SQL migration files so they ship inside
// the compiled binary rather than depending on the source tree being
// present at runtime (relevant once the app is deployed rather than run
// from a checked-out repo).
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
