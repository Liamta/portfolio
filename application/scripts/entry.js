// Components
import WorkItems from './components/WorkItems';


// NodeList Polyfill for forEach
if (window.NodeList && !NodeList.prototype.forEach) {
    NodeList.prototype.forEach = function (callback, thisArg) {
        thisArg = thisArg || window;
        for (let i = 0; i < this.length; i++) {
            callback.call(thisArg, this[i], i, this);
        }
    };
}

/**
 * Entry point
 */
window.onload = () => {

    new WorkItems();

};
