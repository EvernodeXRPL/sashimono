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
    src/util/util.cpp
    src/conf.cpp
    src/main.cpp
)

target_link_libraries(sagent
    ${CMAKE_DL_LIBS} # Needed for stacktrace support
)

target_precompile_headers(sagent PUBLIC src/pchheader.hpp)
