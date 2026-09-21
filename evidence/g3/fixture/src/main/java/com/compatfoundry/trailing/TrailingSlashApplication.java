package com.compatfoundry.trailing;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.PathMatchConfigurer;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** Runs the minimal HTTP fixture used to compare Spring MVC path matching. */
@SpringBootApplication
public class TrailingSlashApplication {
    /** Starts the embedded Spring server. */
    public static void main(String[] args) {
        SpringApplication.run(TrailingSlashApplication.class, args);
    }
}

/** Exposes a route whose trailing-slash behavior is observable over HTTP. */
@RestController
class GreetingController {
    /** Returns the legacy response for the canonical route. */
    @GetMapping("/api/greeting")
    public String greeting() {
        return "Hello from legacy route";
    }
}

/** Restores Spring 5-style trailing-slash matching when explicitly enabled. */
@Configuration
@ConditionalOnProperty(name = "compat.trailing-slash", havingValue = "true")
class TrailingSlashCompatibilityConfiguration implements WebMvcConfigurer {
    /** Enables the compatibility match for paths ending in a slash. */
    @Override
    public void configurePathMatch(PathMatchConfigurer configurer) {
        configurer.setUseTrailingSlashMatch(true);
    }
}
