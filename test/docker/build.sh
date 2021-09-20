#!/bin/bash

img=hotpocketdev/sashimono

docker build -t $img:hp.latest-ubt.20.04 -f ./Dockerfile.ubt.20.04 .
docker build -t $img:hp.latest-ubt.20.04-njs.14 -f ./Dockerfile.ubt.20.04-njs .