/* globals process */

// Imports
import Gulp from 'gulp';
import Browserify from 'browserify';
import Babelify from 'babelify';
import Watchify from 'watchify';
import Envify from 'envify';
import LiveLoad from 'livereactload';
import Source from 'vinyl-source-stream2';
import Gutil from 'gulp-util';
import Size from 'gulp-size';
import Minify from 'gulp-minify';
import Clean from 'gulp-clean';
import Sourcemaps from 'gulp-sourcemaps';

// Check whether we are in production environment or not
const isProd = process.env.ENV === 'production';


/**
 * Create browserify bundler
 *
 * @return {*}
 */
const createBundle = () => {

    return Browserify({
        entries: ['./application/scripts/entry.js'],
        transform: [
            [Babelify, {}],
            [Envify, {}]
        ],
        plugin: [ Watchify, LiveLoad ],
        debug: !isProd,
        cache: {},
        packageCache: {},
        fullPaths: !isProd
    });

};


/**
 * Scripts (bundle)
 * Build Javascript bundles
 *
 * @uses {gulp, browserify, watchify, babelify, envify, livereactload, gulp-util, vinyl-buffer, vinyl-source-stream}
 */
Gulp.task('scripts:bundle', () => {

    const bundle = createBundle();

    // processing method
    let build = () => {
        return bundle.bundle()
            .on('error', (err) => Gutil.log(err.stack))
            .pipe(Source(isProd ? 'bundle.min.js' : 'bundle.js'))
            .pipe(isProd ? Minify() : Gutil.noop())
            .pipe(Size())
            .pipe(Sourcemaps.init())
            .pipe(Sourcemaps.write('./'))
            .pipe(Gulp.dest('distribution/assets/scripts/'));
    };

    // on change
    bundle.on('update', () => {
        const updateStart = Date.now();
        build().on('end', () => Gutil.log(`...Done compiling scripts in ${Date.now() - updateStart} ms`));
    });

    // kick-off
    return build();

});


/**
 * Clean scripts directory
 *
 * @uses {gulp, gulp-clean}
 */
Gulp.task('scripts:clean', () => {

    return Gulp.src('distribution/assets/scripts/')
        .pipe(Clean())

});
