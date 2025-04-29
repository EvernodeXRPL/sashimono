#!/bin/bash

img=evernode/sashimono

docker image push "$img:hp.test-ubt.20.04"
docker image push "$img:hp.test-ubt.20.04-njs.20"