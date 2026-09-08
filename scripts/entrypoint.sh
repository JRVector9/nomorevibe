#!/bin/sh
# Schema migrations run once per release, before any web or worker consumer starts.
set -eu
exec node server.js
