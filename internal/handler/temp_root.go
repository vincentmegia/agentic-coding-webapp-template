package handler

import "net/http"

// TemporaryRoot is a scaffolding-only smoke test handler for GET /.
//
// TEMPORARY: this exists only to verify the server boots and the compiled
// Tailwind CSS is actually wired up end-to-end. It must be replaced by the
// real page/layout feature (web/templates/layouts/base.html + pages), which
// is out of scope for this task. Do not build on top of this handler.
func TemporaryRoot(w http.ResponseWriter, r *http.Request) {
	const page = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>vincentmegia.com (scaffolding)</title>
	<link rel="stylesheet" href="/static/css/output.css">
</head>
<body class="min-h-screen bg-surface flex items-center justify-center">
	<div class="rounded-card border p-6">
		<p class="text-brand text-2xl font-semibold">Scaffolding is up.</p>
		<p class="text-slate-500 mt-2">Replace this with the real layout in Wave 1.</p>
	</div>
</body>
</html>`

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(page))
}
