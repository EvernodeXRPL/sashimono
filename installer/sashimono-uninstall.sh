#!/bin/bash
# Sashimono agent uninstall script.

docker_bin=/usr/bin/sashimono-dockerbin

# TODO: Uninstall all contract instance users

echo "Deleting binaries..."
rm -r $docker_bin

echo "Done."
