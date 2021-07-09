#include "version.hpp"

namespace version
{
    /**
     * Compare two version strings in the format of "1.12.3".
     * v1 <  v2  -> returns -1
     * v1 == v2  -> returns  0
     * v1 >  v2  -> returns +1
     * Error     -> returns -2
     * 
     * Remark on string_view: In other places of the code-base we utilize string_view
     * to pass immutable string references around. However in this function we keep the 'const string&'
     * syntax because istringstream doesn't support string_view. It's not worth optimising
     * this code as it's not being used in high-scale processing.
     */
    int version_compare(const std::string &x, const std::string &y)
    {
        std::istringstream ix(x), iy(y);
        while (ix.good() || iy.good())
        {
            int cx = 0, cy = 0;
            ix >> cx;
            iy >> cy;

            if ((!ix.eof() && !ix.good()) || (!iy.eof() && !iy.good()))
                return -2;

            if (cx > cy)
                return 1;
            if (cx < cy)
                return -1;

            ix.ignore();
            iy.ignore();
        }

        return 0;
    }
}