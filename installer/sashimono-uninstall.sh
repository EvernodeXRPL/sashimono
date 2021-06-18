#!/bin/bash
# Sashimono agent uninstall script.

sashimono_bin=/usr/bin/sashimono-agent

# TODO: Uninstall all contract instance users

echo "Deleting binaries..."
rm -r $sashimono_bin

echo "Done."
