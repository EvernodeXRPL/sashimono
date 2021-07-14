#!/bin/bash

repo=hotpocketdev/sashimono

./build.sh
docker push $repo:hp-ubt.20.04
docker push $repo:hp-ubt.20.04-njs.14