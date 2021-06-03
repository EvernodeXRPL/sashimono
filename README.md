# Sashimono Agent

## What's here?
*In development*

A C++ version of sashimono agent

## Libraries
* jsoncons (for JSON and BSON) - https://github.com/danielaparker/jsoncons
* Boost Stacktrace - https://www.boost.org

## Setting up Sashimono Agent environment
Run the setup script located at the repo root (tested on Ubuntu 18.04).
```
./dev-setup.sh
```

## Build Sashimono Agent
1. Run `cmake .` (You only have to do this once)
1. Run `make` (Sashimono agent binary will be created as `./build/sagent`)

## Code structure
Code is divided into subsystems via namespaces.

**conf::** Handles configuration. Loads and holds the central configuration object. Used by most of the subsystems.

**salog::** Handles logging. Creates and prints the logs according to the configured log section in the json config.

**comm::** Handles generic web sockets communication functionality. Mainly acts as a wrapper for [hpws](https://github.com/RichardAH/hpws).

**util::** Contains shared data structures/helper functions used by multiple subsystems.

**sqlite::** Contains sqlite database management related helper functions.