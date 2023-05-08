#!/bin/bash

img=evernodedev/sashimono

docker build -t $img:hp.latest-ubt.20.04 -t $img:hp.0.6.1-ubt.20.04 -f ./Dockerfile.ubt.20.04 .
docker build -t $img:hp.latest-ubt.20.04-njs.16 -t $img:hp.0.6.1-ubt.20.04-njs.16 -f ./Dockerfile.ubt.20.04-njs .