#!/bin/bash

repo=hotpocketdev/sashimono

docker build -t $repo:hp-ubt.20.04 -f ./Dockerfile.ubt.20.04 .
docker build -t $repo:hp-ubt.20.04-njs.14 -f ./Dockerfile.ubt.20.04-njs .