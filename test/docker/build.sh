#!/bin/bash

img=evernode/sashimono

docker build -t $img:hp.latest-ubt.20.04 -t $img:hp.0.6.4-ubt.20.04 -f ./Dockerfile.ubt.20.04 .
docker build -t $img:hp.latest-ubt.20.04-njs.20 -t $img:hp.0.6.4-ubt.20.04-njs.20 -f ./Dockerfile.ubt.20.04-njs .
