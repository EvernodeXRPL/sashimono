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

## Setting up Sashimono Agent environment
- Place a hotpocket contract named **default_contract** (Copies of this contract will be made when new instances are created) inside the **dependencies** directory. This should be a new contract (Created by `hpcore new`) which has configured binaries in hp.cfg. In the future this will be placed by the installation process.

- Run the setup script located at the repo root (tested on Ubuntu 18.04).
```
./dev-setup.sh
```

## Build Sashimono Agent
1. Run `cmake .` (You only have to do this once)
1. Run `make` (Sashimono agent binary will be created as `./build/sagent`)

## Code structure
Code is divided into subsystems via namespaces.

**comm::** Handles generic web sockets communication functionality. Mainly acts as a wrapper for [hpws](https://github.com/RichardAH/hpws).

**conf::** Handles configuration. Loads and holds the central configuration object. Used by most of the subsystems.

**crypto::** Handles cryptographic activities. Wraps libsodium and offers convenience functions.

**hp::** Contains hotpocket instance management related helper functions.

**msg::** Extract message data from received raw messages.

**salog::** Handles logging. Creates and prints the logs according to the configured log section in the json config.

**sqlite::** Contains sqlite database management related helper functions.

**util::** Contains shared data structures/helper functions used by multiple subsystems.

