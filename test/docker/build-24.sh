#!/bin/bash

img=evernode/sashimono

# Noble Numbat
docker build -t $img:hp.latest-ubt.24.04 -t $img:hp.0.6.4-ubt.24.04 -f ./Dockerfile.ubt.24.04 .
docker build -t $img:hp.latest-ubt.24.04-njs.20 -t $img:hp.0.6.4-ubt.24.04-njs.20 -f ./Dockerfile.ubt.24.04-njs .