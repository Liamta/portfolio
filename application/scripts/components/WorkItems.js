/**
 * Work Items
 */
export default class WorkItems {


    /**
     * @constructor
     */
    constructor() {

        // Elements
        this.container = document.querySelector('[data-work="container"]');
        this.list = this.container.querySelector('[data-work="items"]');
        this.items = this.container.querySelectorAll('[data-work="item"]');
        this.media = this.container.querySelector('[data-work="media"]');
        this.video = this.container.querySelector('[data-work="video"]');
        this.videoSrc = this.video.querySelector('[data-video="src"]');

        this.pagination = this.container.querySelector('[data-work="pagination"]');
        this.paginationList = this.container.querySelector('[data-pagination="list"]');

        this.accents = this.container.querySelector('[data-work="accents"]');
        this.projectCount = this.accents.querySelector('[data-accent="project"]');

        console.log(this.accents);

        // Generate Items
        this.itemsArr = this.generateItemsArray(this.items);
        this.itemsMap = this.generateItemsMap(this.items);
        this.paginationItems = this.generatePaginationItems(this.items.length);

        // Item Values
        this.currentItem = 0;
        this.prevItem = this.currentItem;

        this.isAnimating = false;

        this.mousePos = {};
        this.mouseThreshold = 150;

        window.addEventListener('mousemove', this.onMouseMove.bind(this));
        window.addEventListener('mousewheel', this.onMouseWheel.bind(this));

        // Initialize application
        setTimeout(() => this.init(), 500);

    }


    /**
     * Initialize the active item.
     *
     * @method
     * @returns void
     */
    init() {

        this.container.classList.remove('transitioning');
        this.pagination.classList.remove('loading');
        this.setActiveItem(0);

    }


    /**
     * Set th active item in the list
     *
     * @method
     * @param {Number} index
     * @returns void
     */
    setActiveItem(index) {

        if(!this.isAnimating && index >= 0 && index <= this.itemsArr.length - 1) {

            this.isAnimating = true;

            this.prevItem = this.currentItem;
            this.currentItem = index;

            this.container.classList.add('transitioning');
            this.itemsMap[this.prevItem].el.classList.remove('active');

            this.paginationItems[this.prevItem].classList.remove('active');
            this.paginationList.style.transform = 'translateX(-' + 46 * this.currentItem + 'px)';

            // Delay the next item animations.
            setTimeout(() => {

                this.isAnimating = false;

                this.videoSrc.src = this.itemsMap[this.currentItem].el.getAttribute('data-media');

                this.container.classList.remove('transitioning');
                this.itemsMap[this.currentItem].el.classList.add('active');
                this.paginationItems[this.currentItem].classList.add('active');

                this.projectCount.innerHTML = '0' + (index + 1);

            }, 1500);

        }

    }


    /**
     * Generate an array from the work items in the DOM.
     *
     *
     * @param {NodeList} nodeList
     * @returns {Array}
     */
    generateItemsArray(nodeList) {

        const items = [];

        nodeList.forEach((element, index) => items.push({
            index: index,
            el: element
        }));

        return items;

    }


    /**
     * Generate a map of the items
     *
     * @method
     * @param {NodeList} nodeList
     * @returns {Object}
     */
    generateItemsMap(nodeList) {

        const map = {};

        nodeList.forEach((element, index) => {

            const name = element.getAttribute('data-name');

            map[index] = {
                index: index,
                name: name,
                el: element
            };

        });

        return map;

    }


    /**
     * Generate the items for the pagination
     *
     * @method
     * @param {Number} count
     * @returns {Object}
     */
    generatePaginationItems(count) {

        const map = {};

        for (let i = 0; i < count; i++) {

            const item = document.createElement('li');
            item.classList.add('work-pagination__item');
            item.setAttribute('data-pagination', 'item');
            item.setAttribute('data-index', i);
            item.addEventListener('click', this.onPaginationClick.bind(this));

            if(i === 0) item.classList.add('active');

            this.paginationList.appendChild(item);

            map[i] = item;

        }

        return map;

    }


    /**
     * Update the moving elements within the app based on mouse position.
     *
     * @method
     * @returns void
     */
    updateMovement() {

        this.video.style.transform = 'rotateX(' + this.mousePos.x + 'deg) rotateY(' + this.mousePos.y + 'deg)';
        this.itemsMap[this.currentItem].el.style.transform = 'translateX(' + Math.round(this.mousePos.y * 100) / 100 + '%) translateY(-50%)';
        this.pagination.style.transform = 'translateX(' + this.mousePos.y + '%)';
        this.pagination.style.marginBottom = this.mousePos.x + 'px';

    }


    /**
     * On pagination item click, change item.
     *
     * @method
     * @param {Object} event
     * @returns void
     */
    onPaginationClick(event) {
        this.setActiveItem(parseInt(event.currentTarget.getAttribute('data-index')));
    }


    /**
     * On scroll, change item.
     *
     * @method
     * @param {Object} event
     * @returns void
     */
    onMouseWheel(event) {

        event.preventDefault();

        if(event.deltaY > this.mouseThreshold) this.setActiveItem(this.currentItem + 1);
            else if(event.deltaY < -this.mouseThreshold) this.setActiveItem(this.currentItem - 1);

    }


    /**
     * On mouse move, set our X and Y
     *
     * @method
     * @param {Object} event
     * @returns void
     */
    onMouseMove(event) {

        this.mousePos = {
            y: (0.5 - event.screenX / window.innerWidth) * 5,
            x: (0.5 - event.screenY / window.innerHeight) * 5
        };

        this.updateMovement();

    }

}
