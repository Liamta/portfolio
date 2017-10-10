// Imports
import Gulp from 'gulp';
import Twig from 'gulp-twig';
import Clean from 'gulp-clean';


/**
 * Serve files over a local server
 *
 * @uses {gulp, gulp-nodemon}
 */
Gulp.task('templates:compile', () => {

    return Gulp.src('application/views/pages/**.twig')
        .pipe(Twig({ env: process.env.ENV }))
        .pipe(Gulp.dest('distribution/'))

});


/**
 * Clean templates directory
 *
 * @uses {gulp, gulp-clean}
 */
Gulp.task('templates:clean', () => {

    return Gulp.src('distribution/assets/templates/')
        .pipe(Clean())

});
