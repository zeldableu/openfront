#!/usr/bin/env sh
# Met à jour OF_REFRESH_TOKEN — usage : ./update-token.sh [token]
node "$(dirname "$0")/update-token.js" "$1"
