// Imports
import Gulp from 'gulp';
import Sass from 'gulp-sass';
import CleanCSS from 'gulp-clean-css';
import Concat from 'gulp-concat';
import Clean from 'gulp-clean';
import Sourcemaps from 'gulp-sourcemaps';


/**
 * Bundle SCSS
 *
 * @uses {gulp, gulp-sass, gulp-clean-css, gulp-concat}}
 */
Gulp.task('styles:bundle', () => {

    return Gulp.src('application/styles/**/**.scss')
        .pipe(Sourcemaps.init())
        .pipe(Sass().on('error', Sass.logError))
        .pipe(CleanCSS())
        .pipe(Concat('styles.css'))
        .pipe(Sourcemaps.write('./'))
        .pipe(Gulp.dest('distribution/assets/styles/'));

});


/**
 * Clean styles directory
 *
 * @uses {gulp, gulp-clean}
 */
Gulp.task('scripts:clean', () => {

    return Gulp.src('distribution/assets/styles/')
        .pipe(Clean())

});
