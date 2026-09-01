function frameAncestorsHandler(request, response, next) {
	response.set('Content-Security-Policy', "frame-ancestors 'none'");
	response.set('X-Frame-Options', 'DENY');
	next();
}

export default frameAncestorsHandler;
