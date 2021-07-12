cmake_minimum_required(VERSION 3.16)
project(sagent)

# Force build type to Release build.
set(CMAKE_BUILD_TYPE Release)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_ARCHIVE_OUTPUT_DIRECTORY build)
set(CMAKE_LIBRARY_OUTPUT_DIRECTORY build)
set(CMAKE_RUNTIME_OUTPUT_DIRECTORY build)

set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -Wno-unused-result -Wreturn-type")

#-------Bootstrap contract-------

add_executable(bootstrap_contract
    bootstrap-contract/bootstrap_contract.cpp
)

#-------Sashimono Agent-------

add_subdirectory(src/killswitch)

add_executable(sagent
    src/conf.cpp
    src/comm/comm_handler.cpp
    src/comm/comm_session.cpp
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
)

add_custom_command(TARGET sagent POST_BUILD
    COMMAND bash -c "cp -r ./dependencies/{hpfs,hpws,user-install.sh,user-uninstall.sh} ./build/"
    COMMAND tar xf ./dependencies/contract_template.tar -C ./build/ --no-same-owner
    COMMAND cp ./dependencies/hp.cfg ./build/contract_template/cfg/
    COMMAND cp ./bootstrap-contract/script.sh ./build/contract_template/contract_fs/seed/state/
    COMMAND mv ./build/bootstrap_contract ./build/contract_template/contract_fs/seed/state/
    COMMAND ./installer/docker-install.sh ./build/dockerbin
)

target_precompile_headers(sagent PUBLIC src/pchheader.hpp)

# Add target to generate the installer setup.
add_custom_target(installer
  COMMAND mkdir -p ./build/sashimono-installer
  COMMAND bash -c "cp -r ./build/{sagent,hpfs,hpws,user-install.sh,user-uninstall.sh,contract_template} ./build/sashimono-installer/"
  COMMAND bash -c "cp -r ./installer/{docker-install.sh,sashimono-install.sh,sashimono-uninstall.sh} ./build/sashimono-installer/"
  COMMAND tar cfz  ./build/sashimono-installer.tar.gz --directory=./build/ sashimono-installer
  COMMAND rm -r ./build/sashimono-installer
)
set_target_properties(installer PROPERTIES EXCLUDE_FROM_ALL TRUE)
add_dependencies(installer sagent)
