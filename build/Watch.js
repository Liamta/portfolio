// Imports
import Gulp from 'gulp';

/**
 * Watch for file changes and bundle assets again
 *
 * @uses {gulp}
 */
Gulp.task('watch', () => {

    Gulp.watch('application/styles/**/**.scss', ['styles:bundle']);
    Gulp.watch('application/views/**/**.twig', ['templates:compile']);

});
