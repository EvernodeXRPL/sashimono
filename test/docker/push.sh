#!/bin/bash

repo=hotpocketdev/sashimono

./build.sh
docker push $repo:ubt.20.04
docker push $repo:ubt.20.04-njs.14