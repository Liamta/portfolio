// Imports
import Gulp from 'gulp';
import Server from 'gulp-server-livereload';


/**
 * Serve files over a local server
 *
 * @uses {gulp, gulp-nodemon}
 */
Gulp.task('serve', ['scripts:bundle', 'watch'], () => {

    return Gulp.src('./distribution')
    .pipe(Server({
        host: '0.0.0.0',
        port: 8080,
        livereload: {
            enable: true,
            filter: (filePath, cb) => cb(!(/bundle\.js/.test(filePath)))
        }
    }));

});
