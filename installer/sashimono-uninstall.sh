#!/bin/bash
# Sashimono agent uninstall script.

sashimono_bin=/usr/bin/sashimono-agent
docker_bin=/usr/bin/sashimono-dockerbin

# TODO: Uninstall all contract instance users

echo "Deleting binaries..."
rm -r $sashimono_bin
rm -r $docker_bin

echo "Done."
