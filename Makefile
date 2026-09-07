.DEFAULT_GOAL := dev
.PHONY: dev build test package

dev:
	npm run dev

build:
	npm run build

test:
	npm test

package:
	npm run package
