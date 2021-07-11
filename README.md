# Sashimono Agent

## What's here?
*In development*

A C++ version of sashimono agent

## Libraries
* Crypto - Libsodium https://github.com/jedisct1/libsodium
* jsoncons (for JSON and BSON) - https://github.com/danielaparker/jsoncons
* Boost Stacktrace - https://www.boost.org
* Reader Writer Queue - https://github.com/cameron314/readerwriterqueue
* Concurrent Queue - https://github.com/cameron314/concurrentqueue
* Boost Stacktrace - https://www.boost.org

## Setting up Sashimono Agent development environment
1. Run `sudo ./prereq.sh`
1. Reboot the machine.
1. Run `./dev-setup.sh`

## Build Sashimono Agent
1. Run `cmake .` (You only have to do this once)
1. Run `make` (Sashimono agent binary 'sagent' and dependencies will be placed in build directory)

## Build Sashimono installer
Run `make installer` ('sashimono-installer.tar.gz' will be placed in build directory)

## Run Sashimono
1. `cd examples/message-board && npm install` (You only have to do this once)
1. `node message-board.js` (Message board simulator will start listening at port 5000)
1. `./build/sagent new` (This will create the Sashimono config in build directory. You only have to do this once)
1. `sudo ./build/sagent run`

## Sashimono Client
- Replace the sashimono-client.key file created inside dataDir in the first run by the key file found on this [link](https://geveoau.sharepoint.com/:u:/g/EX5U8SxYyM5Anyq2rAcMXtkBEOO_XWT7hCo30SGIsDAyLg?e=LycwQx). This is because we have hardcoded the pubkey in message board. This will generate the same pubkey we have hardcoded.
- A sample **bundle.zip** bundle can be found [here](https://geveoau.sharepoint.com/:u:/g/EdurCbuttzdCnuQCyIb0SKEBWq4j9LKdgAIjJvt3zwueew?e=lPYfMG).

## Code structure
Code is divided into subsystems via namespaces.

**comm::** Handles generic web sockets communication functionality. Mainly acts as a wrapper for [hpws](https://github.com/RichardAH/hpws).

**conf::** Handles configuration. Loads and holds the central configuration object. Used by most of the subsystems.

**crypto::** Handles cryptographic activities. Wraps libsodium and offers convenience functions.

**hp::** Contains hotpocket instance management related helper functions.

**hpfs::** Contains hpfs instance management related helper functions.

**msg::** Extract message data from received raw messages.

**salog::** Handles logging. Creates and prints the logs according to the configured log section in the json config.

**sqlite::** Contains sqlite database management related helper functions.

**util::** Contains shared data structures/helper functions used by multiple subsystems.

