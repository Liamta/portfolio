// Imports
import Gulp from 'gulp';
import Imagemin from 'gulp-imagemin';
import Newer from 'gulp-newer';
import Clean from 'gulp-clean';

/**
 * Compress all source imagery
 *
 * @uses {gulp, gulp-imagemin, gulp-newer}
 */
Gulp.task('images:compress', () => {

    return Gulp.src('application/images/**/**')
        .pipe(Newer('distribution/images'))
        .pipe(Imagemin({
            interlaced: true,
            progressive: true,
            optimizationLevel: 5
        }))
        .pipe(Gulp.dest('distribution/assets/images/'))

});


/**
 * Clean image directory
 *
 * @uses {gulp, gulp-clean}
 */
Gulp.task('images:clean', () => {

    return Gulp.src('distribution/assets/images/')
        .pipe(Clean())

});
