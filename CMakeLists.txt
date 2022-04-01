cmake_minimum_required(VERSION 3.16)
project(sagent)

# Force build type to Release build.
set(CMAKE_BUILD_TYPE Release)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY build)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY build)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY build)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wall -Werror")

#-------Bootstrap contract-------

add_executable(bootstrap_contract
    bootstrap-contract/bootstrap_contract.cpp
)

#-------Sashi CLI-------

add_executable(sashi
    sashi-cli/cli-manager.cpp
    sashi-cli/main.cpp
)

target_link_libraries(sashi
    libboost_stacktrace_backtrace.a
    ${CMAKE_DL_LIBS} # Needed for stacktrace support
)

#-------Sashimono Agent-------

add_subdirectory(src/killswitch)

add_executable(sagent
    src/conf.cpp
    src/comm/comm_handler.cpp
    src/util/util.cpp
    src/salog.cpp
    src/crypto.cpp
    src/sqlite.cpp
    src/hp_manager.cpp
    src/hpfs_manager.cpp
    src/msg/msg_parser.cpp
    src/msg/json/msg_json.cpp
    src/main.cpp
)

target_link_libraries(sagent
    killswitch
    libsodium.a
    libboost_stacktrace_backtrace.a
    sqlite3
    pthread
    ${CMAKE_DL_LIBS} # Needed for stacktrace support
)

add_dependencies(sagent
    bootstrap_contract
    sashi
)

add_custom_command(TARGET sagent POST_BUILD
    COMMAND bash -c "cp -r ./dependencies/{hpfs,user-install.sh,user-uninstall.sh} ./build/"
    COMMAND tar xf ./dependencies/contract_template.tar -C ./build/ --no-same-owner
    COMMAND cp ./dependencies/hp.cfg ./build/contract_template/cfg/
    COMMAND cp ./bootstrap-contract/bootstrap_upgrade.sh ./build/contract_template/contract_fs/seed/state/
    COMMAND mv ./build/bootstrap_contract ./build/contract_template/contract_fs/seed/state/
    COMMAND ./installer/docker-install.sh ./build/dockerbin
    COMMAND npm  --prefix ./mb-xrpl install && npm run --prefix ./mb-xrpl build
)

target_precompile_headers(sagent PUBLIC src/pchheader.hpp)

# Add target to generate the installer setup.
add_custom_target(installer
  COMMAND mkdir -p ./build/installer
  COMMAND bash -c "cp -r ./build/{sagent,sashi,hpfs,user-install.sh,user-uninstall.sh,contract_template} ./build/installer/"
  COMMAND bash -c "cp -r ./installer/{docker-install.sh,registry-install.sh,registry-uninstall.sh,prereq.sh,sashimono-install.sh,sashimono-uninstall.sh} ./build/installer/"
  COMMAND bash -c "cp -r ./dependencies/{user-cgcreate.sh,libblake3.so,licence.txt} ./build/installer/"
  COMMAND bash -c "cp -r ./mb-xrpl/dist ./build/installer/mb-xrpl"
  COMMAND tar cfz  ./build/installer.tar.gz --directory=./build/ installer
  COMMAND rm -r ./build/installer
)
set_target_properties(installer PROPERTIES EXCLUDE_FROM_ALL TRUE)
add_dependencies(installer sagent)
