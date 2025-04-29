#!/bin/bash

img=evernode/sashimono

docker build -t $img:hp.test-ubt.20.04 -f ./Dockerfile.ubt.20.04 .
docker build -t $img:hp.test-ubt.20.04-njs.20 -f ./Dockerfile.ubt.20.04-njs .
