// Desktop app: the same static web build as the phone apps (frontend/out), shown in a
// native window by Wails, plus a Bluetooth link layer (mesh.go) so the offline mesh works.
//
// Build it from frontend/ with `npm run desktop` (see README). The web files are copied into
// dist/ first, because Go can only embed files inside this folder.
package main

import (
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:dist
var dist embed.FS

func main() {
	assets, err := fs.Sub(dist, "dist")
	if err != nil {
		log.Fatal(err)
	}

	app := NewApp()
	err = wails.Run(&options.App{
		Title:            "Demo Discord",
		Width:            1280,
		Height:           820,
		MinWidth:         380,
		MinHeight:        560,
		BackgroundColour: &options.RGBA{R: 10, G: 10, B: 12, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Windows: &windows.Options{
			// Same folder for every run, so localStorage and IndexedDB (mesh identity and
			// history) survive restarts and updates.
			WebviewUserDataPath: userDataPath(),
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
