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

add_executable(sagent
    src/conf.cpp
    src/comm/comm_handler.cpp
    src/comm/comm_session.cpp
    src/util/util.cpp
    src/salog.cpp
    src/crypto.cpp
    src/sqlite.cpp
    src/hp_manager.cpp
    src/msg/msg_parser.cpp
    src/msg/json/msg_json.cpp
    src/main.cpp
)

target_link_libraries(sagent
    libsodium.a
    libboost_stacktrace_backtrace.a
    sqlite3
    pthread
    ${CMAKE_DL_LIBS} # Needed for stacktrace support
)

add_custom_command(TARGET sagent POST_BUILD
    COMMAND cp ./dependencies/bin/hpws ./build/
    COMMAND cp -r ./dependencies/default_contract ./build/
    COMMAND cp ./bootstrap-contract/script.sh ./build/default_contract/contract_fs/seed/state/script.sh
)

target_precompile_headers(sagent PUBLIC src/pchheader.hpp)
